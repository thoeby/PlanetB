"""LV.11: the world's CID settings, recomputed without any IPFS library.

The expected values are what ipfs-unixfs-importer (the node's importer, with
the options tools/node.mjs passes) answers for the same bytes; a second
implementation agreeing with it is what makes a recorded CID worth having.
"""

import unittest

from splatworld.cid import cid_of


def pattern(n):
    b = bytearray(n)
    for i in range(n):
        b[i] = (i * 31 + (i >> 9)) & 255
    return bytes(b)


class TheCid(unittest.TestCase):
    def test_what_the_importer_answers(self):
        for n, cid in [
            (0, 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku'),
            (1, 'bafkreidogqfzz75tpkmjzjke425xqcrmpcib2p5tg44hnbirumdbpl5adu'),
            (262144, 'bafkreiayteudzjqejhnrj27cthcpera74qrzituppl2bgcjpqrqkzbq2j4'),
            (262145, 'bafybeiftxnthvrddtzejkkyxbxqtoi7l2i3lxijya6fqvucgfhcainvsqu'),
            (1000000, 'bafybeigeoqcdtayoawomz3ye3apepqjfuberuconhdy4lczrewgyawhwzq'),
        ]:
            self.assertEqual(cid_of(pattern(n)), cid, '%d bytes' % n)

    def test_a_tree_deeper_than_one_node(self):
        # 174 chunks fill one node; one more byte needs a second level.
        self.assertEqual(cid_of(pattern(45613057)),
                         'bafybeidjc64tbx3ubrewhscx6ceifpphjlidlsarfouo3xr25ok3m654zm')


if __name__ == '__main__':
    unittest.main()
